package main

import (
	"log"

	"example.com/fiberroutes/app"
)

func main() {
	log.Fatal(app.New().Listen(":3000"))
}
