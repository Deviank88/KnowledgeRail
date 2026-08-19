namespace Acme.Orders.Tests;

public class OrdersControllerTests {
  [Fact]
  public void GetsOrder() {
    controller.Get("42");
  }
}
