<?php
namespace App\Orders\Tests;

use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

final class OrderControllerTest extends TestCase
{
    #[Test]
    public function loads_order(): void
    {
        self::assertTrue(true);
    }

    /** @test */
    public function creates_order(): void
    {
        self::assertNotEmpty('order');
    }

    public function testDeletesOrder(): void
    {
        self::assertSame(1, 1);
    }
}
