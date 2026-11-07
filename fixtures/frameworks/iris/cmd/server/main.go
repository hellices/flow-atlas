package main

import (
	"github.com/kataras/iris/v12"

	"example.com/irisroutes/app"
)

func main() {
	application := iris.New()
	app.Register(application)
	application.Listen(":8080")
}
