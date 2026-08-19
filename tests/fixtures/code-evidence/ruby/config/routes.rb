Rails.application.routes.draw do
  get "/health" => "health#show"
  get "/orders/search", to: "orders#search"
  resources :orders
end
