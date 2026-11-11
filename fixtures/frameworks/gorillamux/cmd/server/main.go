package main

import (
	"log"
	"net/http"

	"example.com/muxroutes/app"
)

func main() {
	log.Fatal(http.ListenAndServe(":8000", app.New()))
}
