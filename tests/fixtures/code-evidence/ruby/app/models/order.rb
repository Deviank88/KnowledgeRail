# Frozen domain model persisted in the orders table.
class Order < ApplicationRecord
  self.table_name = "orders"

  attr_reader :external_id
  attr_accessor :status, :total_cents

  # Return true when fulfillment may begin.
  def ready?
    status == "accepted" && total_cents.positive?
  end

  # Human-readable label used in audit events.
  def label = "Order #{external_id}"
end
