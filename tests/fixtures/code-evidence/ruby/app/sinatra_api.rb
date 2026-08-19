require "sinatra/base"

class OrdersApi < Sinatra::Base
  # Lightweight endpoint used by internal probes.
  get "/health" do
    content_type :json
    { status: "ok" }.to_json
  end

  post "/orders" do
    OrderService.new(repository).place(parsed_order)
    status 202
  end
end
