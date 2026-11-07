package main

import "example.com/fiberroutes/app"

func main() {
	app.New().Listen(":3000")
}
