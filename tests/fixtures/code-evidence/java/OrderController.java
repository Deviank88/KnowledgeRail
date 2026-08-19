package com.acme.orders;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;

/** HTTP entry point for order retrieval. */
@RequestMapping("/orders")
public class OrderController {
  /** Load one order from the repository. */
  @GetMapping("/{id}")
  public Order load(String id) {
    return repository.find(id);
  }
}
