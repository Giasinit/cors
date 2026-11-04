package handler

import (
	"github.com/Giasinit/cors/benchmark"
	"net/http"
)

func Handler(w http.ResponseWriter, r *http.Request) {
	bombardier.Handler{}.ServeHTTP(w, r)
}
