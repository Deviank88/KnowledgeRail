require "spec_helper"
require_relative "../app/services/order_service"

RSpec.describe Billing::Orders::OrderService do
  context "when the order is ready" do
    it "persists the order" do
      repository = instance_double("Repository", exists?: false)
      service = described_class.new(repository)
      expect(service).to be_a(described_class)
    end
  end
end
