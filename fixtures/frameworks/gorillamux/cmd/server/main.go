package main

import (
	"net/http"

	"example.com/muxroutes/app"
)

func main() {
	http.ListenAndServe(":8000", app.New())
}
