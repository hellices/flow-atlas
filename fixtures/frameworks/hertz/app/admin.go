package app

import (
	"context"

	"github.com/cloudwego/hertz/pkg/app"
	"github.com/cloudwego/hertz/pkg/route"
)

// registerAdmin adds the admin routes to the group it is given, a nested group among them.
func registerAdmin(admin *route.RouterGroup) {
	admin.Use(func(ctx context.Context, c *app.RequestContext) { c.Next(ctx) })
	admin.GET("/dashboard", dashboard)
	users := admin.Group("/users")
	users.GET("/", listUsers)
	users.GET("/:id", getUser)
	users.PUT("/:id", putUser)
	users.DELETE("/:id", deleteUser)
}

func dashboard(_ context.Context, c *app.RequestContext)  { ok(c) }
func listUsers(_ context.Context, c *app.RequestContext)  { ok(c) }
func getUser(_ context.Context, c *app.RequestContext)    { ok(c) }
func putUser(_ context.Context, c *app.RequestContext)    { ok(c) }
func deleteUser(_ context.Context, c *app.RequestContext) { ok(c) }
