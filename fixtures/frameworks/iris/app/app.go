// Package app holds the routes of Iris's routing guide (iris-go.gitbook.io/iris/contents/routing): a route for each
// method, Any and Handle, offline routes, parties and PartyFunc, nested parties, typed path parameters and their
// macros, the `path` wildcard, MVC controllers, and the file server.
package app

import (
	"github.com/kataras/iris/v12"
	"github.com/kataras/iris/v12/mvc"
)

// Register adds the application's routes to the application.
func Register(app *iris.Application) {
	app.Get("/", ok)
	app.Handle("GET", "/contact", ok)
	app.Post("/form", ok)
	app.Put("/form", ok)
	app.Delete("/form", ok)
	app.Patch("/form", ok)
	app.Options("/preflight", ok)
	app.Trace("/trace", ok)
	app.Head("/head", ok)
	app.Any("/anything", ok)

	// An offline route: Iris keeps it, but serves it only to Context.Exec until its method changes.
	app.None("/invisible/{username}", ok)

	users := app.Party("/users", authenticated)
	users.Get("/{id:uint64}/profile", ok)
	users.Get("/messages/{id:uint64}", ok)

	app.PartyFunc("/accounts", func(accounts iris.Party) {
		accounts.Use(authenticated)
		accounts.Get("/{id:uint64}/profile", ok)
		accounts.Get("/messages/{id:uint64}", ok)
	})

	app.Get("/assets-wild/{asset:path}", ok)
	app.Get("/profile/{username:string}", ok)
	app.Get("/profile/me", ok)
	app.Get("/user/{userid:int min(1)}", ok)
	app.Delete("/user/{userid:int min(1)}", ok)
	app.Get("/u/{username:string}", ok)
	app.Get("/u/{id:int}", ok)
	app.Get("/u/{uid:uint}", ok)
	app.Get("/u/{firstname:alphabetical}", ok)
	app.Get("/tours/{alias:string regexp(^[a-z0-9]{1,10}[.]xml$)}", ok)
	app.Get("/tours/{alias:string regexp(^[a-z0-9]{1,10}$)}", ok)
	app.Get("/limitchar/{name:string range(1,200) else 400}", ok)
	app.Post("/user/{name:string}/{action:path}", ok)

	registerAPI(app.Party("/api"))

	mvc.New(app.Party("/books")).Handle(new(BookController))

	app.HandleDir("/static", iris.Dir("./app/assets"))
	app.Favicon("./app/resources/favicon.ico")
}

func authenticated(ctx iris.Context) { ctx.Next() }

func ok(ctx iris.Context) { ctx.WriteString(ctx.GetCurrentRoute().Name()) }
