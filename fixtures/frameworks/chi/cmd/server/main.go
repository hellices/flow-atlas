package main

import (
	"log"
	"net/http"

	"example.com/chiroutes/app"
)

func main() {
	log.Fatal(http.ListenAndServe(":3333", app.New()))
}
