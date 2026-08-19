namespace Acme.Orders;

using Microsoft.AspNetCore.Mvc;

/// HTTP entry point for order retrieval.
[Route("api/orders")]
public class OrdersController {
  /// Load one order.
  [HttpGet("{id}")]
  public ActionResult<Order> Get(string id) {
    return repository.Find(id);
  }

  public string Region { get; init; }
}
