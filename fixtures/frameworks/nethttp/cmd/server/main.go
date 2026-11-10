package main

import (
	"log"
	"net/http"

	"example.com/nethttproutes/app"
)

func main() {
	log.Fatal(http.ListenAndServe(":8080", app.New()))
}
