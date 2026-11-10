// Package app holds the routes of Hertz's routing guide (cloudwego.io/docs/hertz/tutorials/basic-feature/route/): a
// route for each method, Any and Handle with a custom method, groups with and without middleware, nested groups,
// parametric and wildcard routes, the EX registrations naming their handler, and static files.
package app

import (
	"context"

	"github.com/cloudwego/hertz/pkg/app"
	"github.com/cloudwego/hertz/pkg/app/middlewares/server/basic_auth"
	"github.com/cloudwego/hertz/pkg/app/server"
	"github.com/cloudwego/hertz/pkg/protocol/consts"
)

// Register adds the application's routes to the server.
func Register(h *server.Hertz) {
	h.GET("/", home)
	h.GET("/get", getting)
	h.POST("/post", posting)
	h.PUT("/put", putting)
	h.DELETE("/delete", deleting)
	h.PATCH("/patch", patching)
	h.HEAD("/head", heading)
	h.OPTIONS("/options", optioning)
	h.Any("/ping_any", anything)
	h.Handle("LOAD", "/load", loading)

	v1 := h.Group("/v1")
	v1.GET("/get", getting)
	v1.POST("/post", posting)
	v2 := h.Group("/v2")
	v2.PUT("/put", putting)
	v2.DELETE("/delete", deleting)

	secured := h.Group("/secured", basic_auth.BasicAuth(map[string]string{"test": "test"}))
	secured.GET("/ping", ping)
	registerAdmin(h.Group("/admin"))

	h.GET("/user/:name", user)
	h.GET("/hertz/:version", version)
	h.GET("/hertz/:version/*action", versionAction)
	h.POST("/hertz/:version/*action", versionAction)
	h.GET("/src/*filepath", source)

	h.GETEX("/named", named, "named_handler")
	h.AnyEX("/named_any", named, "named_any_handler")

	// Static looks the whole request path up under its root: /assets/site.css is ./app/assets/site.css.
	h.Static("/assets", "./app")
	h.StaticFS("/files", &app.FS{
		Root:               "./app/assets",
		PathRewrite:        app.NewPathSlashesStripper(1),
		GenerateIndexPages: true,
	})
	h.StaticFile("/favicon.ico", "./app/resources/favicon.ico")
}

func ok(c *app.RequestContext) { c.String(consts.StatusOK, c.FullPath()) }

func home(_ context.Context, c *app.RequestContext)      { ok(c) }
func getting(_ context.Context, c *app.RequestContext)   { ok(c) }
func posting(_ context.Context, c *app.RequestContext)   { ok(c) }
func putting(_ context.Context, c *app.RequestContext)   { ok(c) }
func deleting(_ context.Context, c *app.RequestContext)  { ok(c) }
func patching(_ context.Context, c *app.RequestContext)  { ok(c) }
func heading(_ context.Context, c *app.RequestContext)   { c.Status(consts.StatusOK) }
func optioning(_ context.Context, c *app.RequestContext) { c.Status(consts.StatusOK) }
func anything(_ context.Context, c *app.RequestContext)  { ok(c) }
func loading(_ context.Context, c *app.RequestContext)   { ok(c) }
func ping(_ context.Context, c *app.RequestContext)      { ok(c) }
func named(_ context.Context, c *app.RequestContext)     { ok(c) }
func user(_ context.Context, c *app.RequestContext) {
	c.String(consts.StatusOK, "Hello %s", c.Param("name"))
}
func version(_ context.Context, c *app.RequestContext) {
	c.String(consts.StatusOK, "Hello %s", c.Param("version"))
}
func versionAction(_ context.Context, c *app.RequestContext) {
	c.String(consts.StatusOK, c.Param("version")+" is "+c.Param("action"))
}
func source(_ context.Context, c *app.RequestContext) { c.String(consts.StatusOK, c.Param("filepath")) }
