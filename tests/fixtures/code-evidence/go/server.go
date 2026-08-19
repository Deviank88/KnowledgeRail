package orders

import (
  "net/http"
  "github.com/go-chi/chi/v5"
)

// Server owns the HTTP handlers.
type Server struct {
  repository Repository
}

// Handle serves one order.
func (s *Server) Handle(w http.ResponseWriter, r *http.Request) {
  r.Get("/orders/{id}", s.Handle)
  _ = `raw { text } // not code`
}
