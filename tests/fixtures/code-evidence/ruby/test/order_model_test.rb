require "minitest/autorun"
require_relative "../app/models/order"

class OrderModelTest < Minitest::Test
  # The conventional test_ prefix is indexed as a test fragment.
  def test_ready_order
    order = Order.new
    assert_equal false, order.ready?
  end
end
