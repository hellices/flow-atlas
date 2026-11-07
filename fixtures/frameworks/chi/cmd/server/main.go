package main

import (
	"net/http"

	"example.com/chiroutes/app"
)

func main() {
	http.ListenAndServe(":3333", app.New())
}
