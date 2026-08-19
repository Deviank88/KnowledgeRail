<!doctype html>
<html>
<body>
  <button onclick="fakeHtmlCall()">Order</button>
</body>
</html>
<?php
namespace App\Orders;

use App\Repository\OrderRepository;
use function App\Support\audit;
use const App\Config\RETRY_LIMIT;

/** Handles order routes. */
#[Route('/api/orders')]
final class OrderController
{
    use TracksChanges;

    /** Load one order. */
    #[Route('/{id}', methods: ['GET'])]
    public function show(string $id): array
    {
        $region = $_ENV['REGION'];
        $queue = config('orders.queue');
        return DB::table('orders')->where('id', $id)->first();
    }
}

Route::post('/orders', [OrderController::class, 'create']);
?>
<script>function fakeHtml() { fakeHtmlCall(); }</script>
<?php
function embedded_helper(): string
{
    $text = <<<'EOT'
function fakeHeredoc() { return 'not code'; }
EOT;
    return $text;
}
?>
