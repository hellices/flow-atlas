// Package app holds the routes of chi's routing guide (go-chi.io/#/pages/routing) and README: a route for each method,
// a custom method, URL parameters within a segment and with a regexp, a wildcard, Route and Group, a router mounted
// with Mount, routes for any method with Handle and HandleFunc, and a file server mounted on a path.
package app

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

func init() {
	chi.RegisterMethod("JELLO")
}

func New() chi.Router {
	r := chi.NewRouter()

	r.Get("/", hello)
	r.Head("/", hello)
	r.Post("/", hello)
	r.Put("/things/{id}", ok)
	r.Patch("/things/{id}", ok)
	r.Delete("/things/{id}", ok)
	r.Options("/things", ok)
	r.Method("JELLO", "/jello", http.HandlerFunc(ok))
	r.MethodFunc(http.MethodGet, "/method-func", ok)
	r.HandleFunc("/ping", ok)
	r.Handle("/handled", http.HandlerFunc(ok))

	r.Route("/articles", func(r chi.Router) {
		r.With(paginate).Get("/", ok)                     // GET /articles
		r.With(paginate).Get("/{month}-{day}-{year}", ok) // GET /articles/01-16-2017
		r.Post("/", ok)                                   // POST /articles
		r.Get("/search", ok)                              // GET /articles/search
		r.Get("/{articleSlug:[a-z-]+}", ok)               // GET /articles/home-is-toronto
		r.Get("/{rid:^[0-9]{5,6}}/revisions", ok)         // GET /articles/12345/revisions
		r.Route("/{articleID}", func(r chi.Router) {
			r.Get("/", ok)    // GET /articles/123
			r.Put("/", ok)    // PUT /articles/123
			r.Delete("/", ok) // DELETE /articles/123
		})
	})

	// Public routes and private routes behind a middleware, on the same path prefix.
	r.Group(func(r chi.Router) {
		r.Get("/assets/{assetURL}", ok)
		r.Get("/manage/url/{path}", ok)
		r.Get("/manage/id/{path}", ok)
	})
	r.Group(func(r chi.Router) {
		r.Use(authMiddleware)
		r.Post("/manage", ok)
	})

	r.Mount("/admin", adminRouter())
	r.Mount("/api", apiRouter())

	r.Get("/files/*", ok)
	r.Mount("/public", http.StripPrefix("/public", http.FileServer(http.Dir("app/public"))))

	return r
}

func hello(w http.ResponseWriter, r *http.Request) { w.Write([]byte("Hello World!")) }
func ok(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte(chi.RouteContext(r.Context()).RoutePattern()))
}

func paginate(next http.Handler) http.Handler       { return next }
func authMiddleware(next http.Handler) http.Handler { return next }
