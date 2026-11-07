// Asks gorilla/mux which routes the application serves: Router.Walk goes through the routes the router matches
// requests against, into its subrouters, and each route reports its full path template (GetPathTemplate) and the
// methods it is restricted to (GetMethods; a route with none takes any). Each route is then requested through
// Router.Match, the router's own lookup, which must pick that route; a path prefix (PathPrefix) is requested with a
// rest of several segments and with nothing after its `/`, to learn which paths mux dispatches to it.
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"runtime/debug"
	"sort"
	"strings"

	"github.com/gorilla/mux"

	"example.com/muxroutes/app"
)

type route struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Raw    string `json:"raw"`
}

// A `{name}` or `{name:pattern}` variable (the pattern may hold braces of its own).
var variable = regexp.MustCompile(`\{(?:[^{}]|\{[^{}]*\})*\}`)

func canonical(path string) string {
	path = variable.ReplaceAllString(path, "{}")
	if path = strings.TrimRight(path, "/"); path == "" {
		return "/"
	}
	return path
}

// sample is a request path for the template: a variable is given the first of a few values its pattern, if it has
// one, takes whole; mux decides whether the path is the route's.
func sample(template string) string {
	return variable.ReplaceAllStringFunc(template, func(v string) string {
		_, pattern, found := strings.Cut(v[1:len(v)-1], ":")
		for _, value := range []string{"value1", "12345", "value-one", "asc"} {
			if !found || regexp.MustCompile("^(?:"+pattern+")$").MatchString(value) {
				return value
			}
		}
		panic("no sample value for " + v)
	})
}

// query is a query string the route's query matchers take, its variables given sample values.
func query(r *mux.Route) string {
	templates, err := r.GetQueriesTemplates()
	if err != nil {
		return ""
	}
	var pairs []string
	for _, t := range templates {
		pairs = append(pairs, sample(t))
	}
	return "?" + strings.Join(pairs, "&")
}

// matches tells whether mux dispatches the request to the route.
func matches(router *mux.Router, r *mux.Route, method, target string) bool {
	var m mux.RouteMatch
	return router.Match(httptest.NewRequest(method, target, nil), &m) && m.MatchErr == nil && m.Route == r
}

func main() {
	router := app.New()
	routes := []route{}
	err := router.Walk(func(r *mux.Route, _ *mux.Router, _ []*mux.Route) error {
		if r.GetHandler() == nil {
			return nil // a subrouter's own route: it dispatches to the routes walked under it
		}
		template, err := r.GetPathTemplate()
		if err != nil {
			return err
		}
		pattern, _ := r.GetPathRegexp()
		prefix := !strings.HasSuffix(pattern, "$")
		methods, err := r.GetMethods()
		if err != nil {
			methods = []string{"*"}
		}
		sort.Strings(methods)
		for _, m := range methods {
			request := m
			if m == "*" {
				request = http.MethodPatch
			}
			if !prefix {
				if target := sample(template) + query(r); !matches(router, r, request, target) {
					return fmt.Errorf("%s %s is not dispatched to the route %q that registers it", request, target, template)
				}
				routes = append(routes, route{Method: m, Path: canonical(template), Raw: template})
				continue
			}
			if !strings.HasSuffix(template, "/") {
				return fmt.Errorf("path prefix %q ends within a segment, which the canonical form cannot write", template)
			}
			// A path prefix takes the rest of the path after its `/`, several segments too, and nothing after it.
			if target := sample(template) + "rest/of/it" + query(r); !matches(router, r, request, target) {
				return fmt.Errorf("%s %s is not dispatched to the path prefix %q", request, target, template)
			}
			routes = append(routes, route{Method: m, Path: strings.TrimSuffix(canonical(template), "/") + "/{**}", Raw: template})
			if matches(router, r, request, sample(template)+query(r)) {
				routes = append(routes, route{Method: m, Path: canonical(template), Raw: template})
			}
		}
		return nil
	})
	if err != nil {
		panic(err)
	}

	version := ""
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == "github.com/gorilla/mux" {
				version = strings.TrimPrefix(dep.Version, "v")
			}
		}
	}
	json.NewEncoder(os.Stdout).Encode(map[string]any{"framework": "gorilla/mux", "version": version, "routes": routes})
}
