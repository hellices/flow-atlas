// Package app holds the routes of gorilla/mux's guide (its README): paths with variables, with and without a regular
// expression, routes restricted to methods and to query values, subrouters on a path prefix (nested, and one that
// adds a method matcher), named routes, a path prefix serving static files and a single page application's catch-all.
// Routes restricted to a host are left out.
package app

import (
	"net/http"
	"os"
	"path/filepath"

	"github.com/gorilla/mux"
)

func New() *mux.Router {
	r := mux.NewRouter()
	r.Use(logging)

	r.HandleFunc("/", home).Methods(http.MethodGet)
	r.HandleFunc("/products", products)
	r.HandleFunc("/products/{key}", product).Methods(http.MethodGet, http.MethodPut)
	r.HandleFunc("/articles", articles).Methods(http.MethodGet)
	r.HandleFunc("/articles/{category}/", articlesCategory)
	r.HandleFunc("/articles/{category}/{id:[0-9]+}", article).Name("article")
	r.HandleFunc("/articles/{category}/{sort:(?:asc|desc|new)}", articlesSorted).Methods(http.MethodGet)
	r.HandleFunc("/search", search).Queries("q", "{q}").Methods(http.MethodGet)
	r.Path("/specific").HandlerFunc(specific)

	// "/shop/", "/shop/{key}/" and "/shop/{key}/details", relative to the subrouter's path prefix.
	s := r.PathPrefix("/shop").Subrouter()
	s.HandleFunc("/", products)
	s.HandleFunc("/{key}/", product)
	s.HandleFunc("/{key}/details", productDetails)

	registerAPI(r.PathPrefix("/api").Subrouter())

	// A subrouter combining a path prefix with a method matcher: its routes take POST only.
	forms := r.PathPrefix("/forms").Methods(http.MethodPost).Subrouter()
	forms.HandleFunc("/contact", submit)
	forms.HandleFunc("/feedback/{topic}", submit)

	// This will serve files under /static/<filename>.
	r.PathPrefix("/static/").Handler(http.StripPrefix("/static/", http.FileServer(http.Dir("app/static"))))

	// The single page application takes every path no route above matches.
	r.PathPrefix("/").Handler(spaHandler{staticPath: "app/build", indexPath: "index.html"})
	return r
}

func registerAPI(api *mux.Router) {
	api.HandleFunc("/health", health).Methods(http.MethodGet)
	v1 := api.PathPrefix("/v1").Subrouter()
	v1.HandleFunc("/users", listUsers).Methods(http.MethodGet)
	v1.HandleFunc("/users", createUser).Methods(http.MethodPost)
	v1.HandleFunc("/users/{id:[0-9]+}", user).Methods(http.MethodGet, http.MethodPut, http.MethodDelete)
	v1.HandleFunc("/users/{id:[0-9]+}/posts/{slug:[a-z-]+}", userPost).Methods(http.MethodGet)
}

// spaHandler serves a file of the static directory if there is one, and its index otherwise.
type spaHandler struct {
	staticPath string
	indexPath  string
}

func (h spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := filepath.Join(h.staticPath, r.URL.Path)
	if fi, err := os.Stat(path); os.IsNotExist(err) || (err == nil && fi.IsDir()) {
		http.ServeFile(w, r, filepath.Join(h.staticPath, h.indexPath))
		return
	}
	http.FileServer(http.Dir(h.staticPath)).ServeHTTP(w, r)
}

func logging(next http.Handler) http.Handler { return next }

func ok(w http.ResponseWriter, r *http.Request) {
	template, _ := mux.CurrentRoute(r).GetPathTemplate()
	w.Write([]byte(template))
}

func home(w http.ResponseWriter, r *http.Request)             { ok(w, r) }
func products(w http.ResponseWriter, r *http.Request)         { ok(w, r) }
func product(w http.ResponseWriter, r *http.Request)          { ok(w, r) }
func productDetails(w http.ResponseWriter, r *http.Request)   { ok(w, r) }
func articles(w http.ResponseWriter, r *http.Request)         { ok(w, r) }
func articlesCategory(w http.ResponseWriter, r *http.Request) { ok(w, r) }
func article(w http.ResponseWriter, r *http.Request)          { ok(w, r) }
func articlesSorted(w http.ResponseWriter, r *http.Request)   { ok(w, r) }
func search(w http.ResponseWriter, r *http.Request)           { ok(w, r) }
func specific(w http.ResponseWriter, r *http.Request)         { ok(w, r) }
func submit(w http.ResponseWriter, r *http.Request)           { ok(w, r) }
func health(w http.ResponseWriter, r *http.Request)           { ok(w, r) }
func listUsers(w http.ResponseWriter, r *http.Request)        { ok(w, r) }
func createUser(w http.ResponseWriter, r *http.Request)       { ok(w, r) }
func user(w http.ResponseWriter, r *http.Request)             { ok(w, r) }
func userPost(w http.ResponseWriter, r *http.Request)         { ok(w, r) }
