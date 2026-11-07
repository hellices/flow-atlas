package main

import (
	"github.com/beego/beego/v2/server/web"

	_ "example.com/beegoroutes/routers"
)

func main() {
	web.Run()
}
