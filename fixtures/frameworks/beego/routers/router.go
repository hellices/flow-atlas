// Package routers registers the application's routes, in the shapes of Beego's routing guide
// (beegodoc.com/en-US/v2.2.x/web/router/): controller style (web.Router with and without a mapping, CtrlGet and its
// siblings, AutoRouter, AutoPrefix, annotations through web.Include), functional style (web.Get and its siblings),
// namespaces (nested, with NSInclude), the route rules (parameters, typed and regular-expression parameters, optional
// parameters, `*`), a mounted http.Handler and a static directory.
package routers

import (
	"net/http"

	"github.com/beego/beego/v2/server/web"

	"example.com/beegoroutes/controllers"
)

func init() {
	ctrl := &controllers.MainController{}
	web.Router("/", ctrl)
	web.Router("/health", ctrl, "get:Health")
	web.Router("/update", ctrl, "post:Update")
	web.Router("/getOrPost", ctrl, "get,post:GetOrPost")
	web.Router("/any", ctrl, "*:Any")

	uc := &controllers.UserController{}
	web.Router("/user", uc)
	web.CtrlGet("api/user/:id", (*controllers.UserController).GetUserById)
	web.CtrlPost("api/user/update", (*controllers.UserController).UpdateUser)
	web.CtrlAny("api/user/home", (*controllers.UserController).UserHome)
	web.CtrlDelete("api/user/delete", (*controllers.UserController).DeleteUser)
	web.CtrlPatch("api/user/patch", (*controllers.UserController).PatchUsers)
	web.CtrlPut("api/user/put", (*controllers.UserController).PutUsers)

	web.Router("/rules/name/*", uc, "post:Splat")
	web.Router("/rules/:username/profile", uc, "get:Profile")
	web.Router("/rules/optional/?:id", uc, "get:Optional")
	web.Router("/rules/numeric/:id([0-9]+)", uc, "get:Numeric")
	web.Router("/rules/int/:id:int", uc, "get:Numeric")
	web.Router("/rules/word/:hi:string", uc, "get:Word")
	web.Router("/rules/cms_:id([0-9]+).html", uc, "get:Page")

	web.AutoRouter(&controllers.ReportController{})
	web.AutoPrefix("api", &controllers.StatusController{})

	web.Get("/hello", controllers.Hello)
	web.Post("/post/hello", controllers.PostHello)
	web.Put("/echo", controllers.Echo)
	web.Delete("/echo", controllers.Echo)
	web.Any("/echo/any", controllers.Echo)

	web.Include(&controllers.CMSController{})

	ns := web.NewNamespace("/v1",
		web.NSCtrlGet("/home", (*controllers.UserController).UserHome),
		web.NSRouter("/user", uc),
		web.NSGet("/health", controllers.Hello),
		web.NSNamespace("/admin",
			web.NSRouter("/user", uc),
		),
		web.NSNamespace("/object",
			web.NSInclude(&controllers.ObjectController{}),
		),
	)
	web.AddNamespace(ns)

	web.Handler("/mounted", http.StripPrefix("/mounted", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("mounted " + r.URL.Path))
	})), true)

	web.SetStaticPath("/assets", "static")
}
