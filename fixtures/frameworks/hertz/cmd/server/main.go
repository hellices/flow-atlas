package main

import (
	"github.com/cloudwego/hertz/pkg/app/server"

	"example.com/hertzroutes/app"
)

func main() {
	h := server.Default(server.WithHostPorts("127.0.0.1:8080"))
	app.Register(h)
	h.Spin()
}
