package app

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// adminRouter is a completely separate router for administrator routes, mounted on the main one.
func adminRouter() http.Handler {
	r := chi.NewRouter()
	r.Get("/", ok)
	r.Get("/accounts", ok)
	r.Route("/users/{userID:[0-9]+}", func(r chi.Router) {
		r.Get("/", ok)
		r.Post("/ban", ok)
	})
	return r
}

func apiRouter() http.Handler {
	r := chi.NewRouter()
	r.Get("/articles/{date}-{slug}", ok)
	return r
}
