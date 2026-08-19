"""Django URL declarations for order views."""

from django.urls import path, re_path
from orders import views

urlpatterns = [
    path("orders/", views.list_orders, name="order-list"),
    re_path(r"^orders/(?P<order_id>[0-9]+)/$", views.order_detail),
]
