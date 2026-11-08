package main

import (
	"log"

	"example.com/ginroutes/app"
)

func main() {
	log.Fatal(app.New().Run(":8080"))
}
