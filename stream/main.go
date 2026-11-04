package main

import (
	"log"
	"net/http"
	"os"
	"time"

	handler "github.com/Giasinit/cors/api"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	server := &http.Server{
		Addr: ":" + port, Handler: http.HandlerFunc(handler.Handler),
		ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second,
	}
	log.Fatal(server.ListenAndServe())
}
