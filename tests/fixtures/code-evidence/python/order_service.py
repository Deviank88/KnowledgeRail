"""Order application service and HTTP entry points."""

import os
from collections.abc import Callable
from fastapi import APIRouter
from sqlalchemy import text as sql_text

router = APIRouter()
REGION = os.environ.get("ORDER_REGION", "eu-west-1")


class OrderService:
    """Coordinate order placement and persistence."""

    table_name = "orders"

    def __init__(self, repository, publisher):
        self.repository = repository
        self.publisher = publisher

    @router.post(
        "/orders",
    )
    async def place(
        self,
        order_id: str,
        *,
        validate: bool = True,
    ) -> dict[str, str]:
        """Validate and persist one order."""
        validator = self._validator(validate)
        validator(order_id)
        self.repository.save(order_id)
        self.publisher.publish(order_id)
        return {"id": order_id, "region": REGION}

    def _validator(self, enabled: bool) -> Callable[[str], None]:
        # Return a closure so handler discovery covers nested functions.
        def validate_order(order_id: str) -> None:
            if enabled and not order_id:
                raise ValueError("order_id")

        return validate_order

    class Metrics:
        """Collect service-local counters."""

        def increment(self, name: str) -> None:
            print(name)


@router.get("/orders/{order_id}")
async def load_order(order_id: str) -> dict[str, str]:
    """Load one order through the public API."""
    query = sql_text("SELECT id FROM orders WHERE id = :order_id")
    return await fetch_one(query, order_id=order_id)


def build_label(order_id: str) -> str:
    template = f"order={order_id} value={lookup("label", order_id)}"
    inert = """
def fake_top_level():
    return class_factory()
"""
    return f"{template}:{len(inert)}"


__all__ = ["OrderService", "load_order"]
