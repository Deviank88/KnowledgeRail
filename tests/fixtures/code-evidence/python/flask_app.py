"""Flask routes used by the order administration API."""

import os
from flask import Blueprint, Flask, jsonify

app = Flask(__name__)


@app.route("/health")
def health():
    """Return service health."""
    return jsonify({"status": "ok"})


@app.route("/admin/orders", methods=["GET", "DELETE"])
def administer_orders():
    queue = os.getenv("ORDER_QUEUE")
    audit("orders", queue)
    return jsonify({"queue": queue})


orders_blueprint = Blueprint("orders", __name__)


@orders_blueprint.route("/blueprint/orders", methods=["POST"])
def create_blueprint_order():
    """Create an order through a Flask blueprint."""
    return jsonify({"created": True})
