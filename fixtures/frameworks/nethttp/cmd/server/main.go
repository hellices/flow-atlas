package main

import (
	"net/http"

	"example.com/nethttproutes/app"
)

func main() {
	http.ListenAndServe(":8080", app.New())
}
