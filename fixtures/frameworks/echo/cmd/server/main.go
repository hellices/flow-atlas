package main

import (
	"log"

	"example.com/echoroutes/app"
)

func main() {
	log.Fatal(app.New().Start(":1323"))
}
