// Asks net/http which routes the application serves. ServeMux keeps no list of its patterns that a program can read, so
// the patterns are recorded as the application registers them on a ServeMux; each is then requested through that
// ServeMux, and only the pattern whose own handler answers counts, so what is written is what ServeMux dispatches. A
// remainder wildcard or subtree is also requested with nothing after its last `/`.
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	"example.com/nethttproutes/app"
)

type route struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Raw    string `json:"raw"`
}

// recorder registers each pattern on a ServeMux, its handler tagged with the registration's number.
type recorder struct {
	mux      *http.ServeMux
	patterns []string
}

func (r *recorder) Handle(pattern string, handler http.Handler) {
	id := strconv.Itoa(len(r.patterns))
	r.patterns = append(r.patterns, pattern)
	r.mux.Handle(pattern, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("X-Route", id)
		handler.ServeHTTP(w, req)
	}))
}

func (r *recorder) HandleFunc(pattern string, handler func(http.ResponseWriter, *http.Request)) {
	r.Handle(pattern, http.HandlerFunc(handler))
}

var (
	rest  = regexp.MustCompile(`\{[^{}]*\.\.\.\}`)
	param = regexp.MustCompile(`\{[^{}$]*\}`)
)

// canonical writes `{name}` as `{}`, and a `{name...}` remainder or a trailing slash, which ServeMux documents as an
// anonymous `...` wildcard, as `{**}`; `{$}` only ends the path.
func canonical(path string) string {
	if strings.HasSuffix(path, "/") {
		path += "{...}"
	}
	path = strings.TrimSuffix(param.ReplaceAllString(rest.ReplaceAllString(path, "\x00"), "{}"), "{$}")
	path = strings.ReplaceAll(path, "\x00", "{**}")
	if path = strings.TrimRight(path, "/"); path == "" {
		return "/"
	}
	return path
}

// answers is the registration whose handler answers the request.
func answers(mux *http.ServeMux, method, path string) string {
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(method, path, nil))
	return w.Header().Get("X-Route")
}

// sample is a request path the pattern matches.
func sample(path string) string {
	if strings.HasSuffix(path, "/") {
		path += "{...}"
	}
	return strings.TrimSuffix(param.ReplaceAllString(rest.ReplaceAllString(path, "rest/of/it"), "value1"), "{$}")
}

func main() {
	r := &recorder{mux: http.NewServeMux()}
	app.Register(r)

	routes := []route{}
	for id, pattern := range r.patterns {
		// ServeMux splits the method from the path at the first space or tab, and trims spaces and tabs before the path.
		method, path := "*", pattern
		if i := strings.IndexAny(pattern, " \t"); i >= 0 {
			method, path = pattern[:i], strings.TrimLeft(pattern[i+1:], " \t")
			if method == "" {
				method = "*"
			}
		}
		if !strings.HasPrefix(path, "/") {
			panic(fmt.Sprintf("%q names a host, which a route's path cannot hold", pattern))
		}
		// A methodless pattern answers any method a pattern for the same path does not name, so methods are tried
		// until it answers one.
		requests := []string{method}
		if method == "*" {
			requests = []string{http.MethodPatch, http.MethodPut, http.MethodDelete, http.MethodPost, http.MethodGet,
				http.MethodHead, http.MethodOptions, http.MethodTrace, http.MethodConnect}
		}
		var request, answered string
		for _, request = range requests {
			if answered = answers(r.mux, request, sample(path)); answered == strconv.Itoa(id) {
				break
			}
		}
		if answered != strconv.Itoa(id) {
			panic(fmt.Sprintf("%s %s is answered by route %q, not by %q that registers it", request, sample(path), answered, pattern))
		}
		routes = append(routes, route{Method: method, Path: canonical(path), Raw: path})
		// A remainder or subtree ServeMux also dispatches with nothing after its last `/` serves that path as well.
		if parent := rest.ReplaceAllString(path, ""); strings.HasSuffix(parent, "/") {
			if answers(r.mux, request, param.ReplaceAllString(parent, "value1")) == strconv.Itoa(id) {
				routes = append(routes, route{Method: method, Path: canonical(strings.TrimSuffix(parent, "/")), Raw: parent})
			}
		}
	}

	version := strings.TrimPrefix(runtime.Version(), "go")
	if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"framework": "net/http", "version": version, "routes": routes}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
