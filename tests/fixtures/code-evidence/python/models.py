"""Persistence models shared by Django and SQLAlchemy examples."""

from django.conf import settings
from django.db import models
from sqlalchemy import Column, MetaData, String, Table
from sqlalchemy.orm import DeclarativeBase

metadata = MetaData()
order_audit = Table(
    "order_audit",
    metadata,
    Column("order_id", String),
)


class Base(DeclarativeBase):
    pass


class OrderRecord(Base):
    """SQLAlchemy order projection."""

    __tablename__ = "orders"
    id = Column(String, primary_key=True)

    def tenant(self) -> str:
        return settings.DEFAULT_TENANT


class Shipment(models.Model):
    """Django shipment projection."""

    order_id = models.CharField(max_length=64)

    class Meta:
        db_table = "shipments"

    def describe(self) -> str:
        statement = "SELECT order_id FROM shipments WHERE order_id = %s"
        return statement
