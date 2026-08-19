class CreateOrders < ActiveRecord::Migration[8.0]
  def change
    create_table :orders do |table|
      table.string :external_id, null: false
      table.string :status, null: false
      table.integer :total_cents, null: false
      table.timestamps
    end
  end
end
