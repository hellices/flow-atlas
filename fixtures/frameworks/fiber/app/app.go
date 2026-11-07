// Package app holds the routes of Fiber's routing guide (docs.gofiber.io/guide/routing and the App API): a route for
// each method, named parameters (after literal text in a segment, an escaped colon), an optional parameter, the
// greedy `+` and `*` parameters, constraints (one, several, a regular expression, on an optional parameter), All, Add
// with several methods, RouteChain, Group and nested groups with middleware, Route, sub-apps mounted with Use (on a
// literal prefix and on one with a parameter), a net/http handler, and static files. Fiber matches paths ignoring
// case by default and reads them lowercased, so the paths here are lowercase.
// Routes the canonical form cannot write are left out: a parameter followed by literal text in its segment
// (`/plantae/:genus.:species`, `/flights/:from-:to`), which Fiber lets take slashes too (`/plantae/a/b.c` is genus
// `a/b`), a greedy parameter in the middle of a path or within a segment (`/v1/*/shop/*`, `/*v1*/proxy`), and Domain
// routes.
package app

import (
	"net/http"

	"github.com/gofiber/fiber/v3"
	"github.com/gofiber/fiber/v3/middleware/static"
)

func New() *fiber.App {
	app := fiber.New()
	Register(app)
	return app
}

// Register adds the application's routes to the app. Fiber matches routes in the order they are registered.
func Register(app *fiber.App) {
	app.Get("/", ok)
	app.Get("/about", ok)
	app.Get("/random.txt", ok)

	app.Get("/user/:name/books/:title", ok)
	app.Get("/shop/product/color::color/size::size", ok)
	app.Get("/api-:version", ok)
	app.Get(`/v1/some/resource/name\:verify`, ok)

	// `?` makes a parameter optional; `+` takes one character or more, slashes included, and `*` none or more.
	app.Get("/user/:name?", ok)
	app.Get("/files/+", ok)
	app.Get("/docs/*", ok)

	app.Get("/orders/:id<int>", ok)
	app.Get(`/orders/:date<regex(\d{4}-\d{2}-\d{2})>`, ok)
	app.Get("/accounts/:username<minLen(4);maxLen(16)>", ok)
	app.Get("/sessions/:id<guid>", ok)
	app.Get("/reports/:year<int>?", ok)

	app.All("/ping", ok)
	app.Add([]string{fiber.MethodGet, fiber.MethodPost}, "/form", ok)
	app.Put("/form", ok)
	app.Delete("/form/:id", ok)
	app.Patch("/form/:id", ok)

	app.RouteChain("/events").All(next).Get(ok).Post(ok)
	app.RouteChain("/reports").RouteChain("/daily").Get(ok)

	api := app.Group("/api", next)
	v1 := api.Group("/v1", next)
	v1.Get("/list", ok)
	v1.Get("/user", ok)
	v2 := api.Group("/v2", next)
	v2.Get("/list", ok)
	v2.Get("/user", ok)

	app.Route("/admin", func(r fiber.Router) {
		r.Get("/users", ok).Name("users")
		r.Post("/users", ok).Name("create")
	}, "admin.")

	micro := fiber.New()
	micro.Get("/doe", ok)
	micro.Put("/doe/:id", ok)
	app.Use("/john", micro)

	tenant := fiber.New()
	tenant.Get("/dashboard", ok)
	app.Use("/t/:tenant", tenant)

	app.Get("/legacy", http.HandlerFunc(legacy))

	// Every other GET path is a file of app/public.
	app.Get("/*", static.New("./app/public"))
}

func ok(c fiber.Ctx) error   { return c.SendString(c.Route().Path) }
func next(c fiber.Ctx) error { return c.Next() }

func legacy(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("legacy")) }
