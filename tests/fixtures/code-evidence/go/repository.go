package orders

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
)

// Store defines the persistence operations required by the order service.
type Store interface {
	Find(ctx context.Context, id string) (Order, error)
	Save(ctx context.Context, order Order) error
}

// SQLStore persists orders in a relational database.
type SQLStore struct {
	db *sql.DB
}

type orderRow struct {
	ID       string `db:"id"`
	Customer string `db:"customer_id"`
	Status   string `db:"status"`
}

// NewSQLStore builds a repository around an existing database handle.
func NewSQLStore(db *sql.DB) *SQLStore {
	return &SQLStore{db: db}
}

// Find loads one order and maps missing rows to a domain error.
func (s *SQLStore) Find(ctx context.Context, id string) (Order, error) {
	const query = `
		SELECT id, customer_id, status
		FROM orders
		WHERE id = ?`

	var row orderRow
	err := s.db.QueryRowContext(ctx, query, id).Scan(&row.ID, &row.Customer, &row.Status)
	if errors.Is(err, sql.ErrNoRows) {
		return Order{}, ErrOrderNotFound
	}
	if err != nil {
		return Order{}, fmt.Errorf("find order: %w", err)
	}
	return hydrateOrder(row), nil
}

// Save persists the current aggregate state in a transaction.
func (s *SQLStore) Save(ctx context.Context, order Order) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin order transaction: %w", err)
	}
	defer tx.Rollback()

	_, err = tx.ExecContext(ctx,
		"INSERT INTO orders (id, customer_id, status) VALUES (?, ?, ?)",
		order.ID(), order.CustomerID(), order.Status(),
	)
	if err != nil {
		return fmt.Errorf("insert order: %w", err)
	}
	return tx.Commit()
}

// RegisterRoutes wires the store-backed HTTP handlers.
func RegisterRoutes(router Router, store Store) {
	handler := NewHandler(store)
	router.Get("/orders/{id}", handler.Get)
	router.Post("/orders", handler.Create)
	http.HandleFunc("/healthz", handler.Health)
}
