package handler

import (
	"github.com/Giasinit/cors/benchmark"
	"net/http"
	"net/url"
)

func Handler(w http.ResponseWriter, r *http.Request) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		http.Error(w, `{"error":"INVALID_QUERY"}`, http.StatusBadRequest)
		return
	}
	if query.Get("collector") == "1" {
		query.Del("collector")
		r.URL.RawQuery = query.Encode()
		bombardier.CollectorHandler{}.ServeHTTP(w, r)
		return
	}
	bombardier.Handler{}.ServeHTTP(w, r)
}
