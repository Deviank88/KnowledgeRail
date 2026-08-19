require "json"
require_relative "../models/order"

module Billing
  module Orders
    # Coordinates validation and persistence for one order.
    class OrderService
      attr_reader :repository

      def initialize(repository)
        @repository = repository
      end

      # Place an order unless it has already been persisted.
      def place(order)
        return repository.find(order.external_id) if repository.exists?(order.external_id)

        if order.ready?
          repository.save(order)
        else
          raise ArgumentError, "order is not ready"
        end
      end

      # Class-level entry point used by background jobs.
      def self.from_environment
        region = ENV["ORDERS_REGION"]
        new(Repository.new(region))
      end
    end
  end
end
