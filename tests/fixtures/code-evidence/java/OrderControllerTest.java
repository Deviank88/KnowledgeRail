package com.acme.orders;

import org.junit.jupiter.api.Test;

class OrderControllerTest {
  @Test
  void loadsAnOrder() {
    controller.load("42");
  }
}
