// Package app holds routes in the patterns of Go's ServeMux (pkg.go.dev/net/http#ServeMux, go.dev/blog/routing-enhancements):
// methods, wildcards, a remainder wildcard, the end anchor {$}, subtrees by a trailing slash, a pattern for any method,
// precedence of the more specific pattern, and a file server on a subtree.
package app

import (
	"net/http"
)

// Mux is what the routes need of a mux; *http.ServeMux has both methods.
type Mux interface {
	Handle(pattern string, handler http.Handler)
	HandleFunc(pattern string, handler func(http.ResponseWriter, *http.Request))
}

func New() *http.ServeMux {
	mux := http.NewServeMux()
	Register(mux)
	return mux
}

func Register(mux Mux) {
	mux.HandleFunc("GET /{$}", ok)
	mux.HandleFunc("/index.html", ok)

	mux.HandleFunc("GET /items", ok)
	mux.HandleFunc("POST /items", ok)
	mux.HandleFunc("GET /items/{id}", ok)
	mux.HandleFunc("PUT /items/{id}", ok)
	mux.HandleFunc("DELETE /items/{id}", ok)
	mux.HandleFunc("GET /items/{id}/reviews/{$}", ok)

	mux.HandleFunc("GET /posts/latest", ok)
	mux.HandleFunc("GET /posts/{id}", ok)

	mux.HandleFunc("GET /files/{path...}", ok)
	mux.HandleFunc("/b/{bucket}/o/{objectname...}", ok)

	mux.HandleFunc("GET /images/", ok)
	mux.HandleFunc("GET /images/thumbnails/", ok)

	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.Dir("app/public"))))
}

func ok(w http.ResponseWriter, r *http.Request) { w.Write([]byte(r.URL.Path)) }
