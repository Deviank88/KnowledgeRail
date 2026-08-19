"""Public typing declarations for the order package."""

from collections.abc import Awaitable, Callable
from typing import Protocol


class OrderRepository(Protocol):
    """Persistence contract."""

    def save(self, order_id: str) -> None: ...
    async def load(self, order_id: str) -> dict[str, str] | None: ...


def with_transaction(
    callback: Callable[[OrderRepository], Awaitable[None]],
) -> Awaitable[None]: ...
