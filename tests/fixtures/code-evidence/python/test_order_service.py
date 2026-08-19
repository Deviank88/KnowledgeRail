"""Tests for the order application service."""

import unittest
import pytest
from python.order_service import OrderService


@pytest.fixture
def repository():
    return FakeRepository()


@pytest.mark.integration
async def test_places_order(repository):
    service = OrderService(repository, FakePublisher())
    result = await service.place("order-1")
    assert result["id"] == "order-1"


class OrderServiceTests(unittest.TestCase):
    """Exercise unittest-style behavior."""

    def setUp(self):
        self.repository = FakeRepository()

    def test_loads_order(self):
        self.assertIsNotNone(self.repository.load("order-1"))


def helper_for_tests():
    return "support"
