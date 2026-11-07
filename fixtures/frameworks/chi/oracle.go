// Asks chi which routes the application serves: chi.Walk goes through the routing tree chi dispatches requests with,
// into the routers mounted on it, and yields each route under the path it is served at. Each route is then looked up
// with Routes.Find, chi's own lookup, which must report that route's pattern; a `/*` wildcard is also looked up with
// nothing after its `/`, to learn whether chi dispatches that path to it as well.
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"runtime/debug"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"

	"example.com/chiroutes/app"
)

type route struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Raw    string `json:"raw"`
}

// A `{name}` or `{name:regexp}` parameter (the regexp may hold braces of its own); a trailing `*` takes the rest.
var param = regexp.MustCompile(`\{(?:[^{}]|\{[^{}]*\})*\}`)

func canonical(pattern string) string {
	path := param.ReplaceAllString(pattern, "{}")
	if strings.HasSuffix(path, "/*") {
		path = strings.TrimSuffix(path, "*") + "{**}"
	}
	if path = strings.TrimRight(path, "/"); path == "" {
		return "/"
	}
	return path
}

// sample is a request path for the pattern: a parameter is given the first of a few values its regexp, if it has one,
// takes whole; chi decides whether the path is the route's.
func sample(pattern string) string {
	path := param.ReplaceAllStringFunc(pattern, func(p string) string {
		_, re, found := strings.Cut(p[1:len(p)-1], ":")
		for _, value := range []string{"value1", "12345", "value-one"} {
			if !found || regexp.MustCompile("^(?:"+strings.TrimSuffix(strings.TrimPrefix(re, "^"), "$")+")$").MatchString(value) {
				return value
			}
		}
		panic("no sample value for " + p)
	})
	if strings.HasSuffix(path, "/*") {
		path = strings.TrimSuffix(path, "*") + "rest/of/it"
	}
	return path
}

// matched is the pattern chi dispatches the request to, as its own lookup reports it.
func matched(r chi.Routes, method, path string) string {
	return strings.ReplaceAll(r.Find(chi.NewRouteContext(), method, path), "/*/", "/")
}

func walk(r chi.Routes) (map[string]map[string]bool, []string) {
	methods := map[string]map[string]bool{}
	var order []string
	err := chi.Walk(r, func(method, pattern string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if methods[pattern] == nil {
			methods[pattern] = map[string]bool{}
			order = append(order, pattern)
		}
		methods[pattern][method] = true
		return nil
	})
	if err != nil {
		panic(err)
	}
	return methods, order
}

func main() {
	// The methods a route for any method (`Handle`) is registered for, as chi itself registers them.
	probe := chi.NewRouter()
	probe.HandleFunc("/", func(http.ResponseWriter, *http.Request) {})
	all, _ := walk(probe)

	router := app.New()
	methods, order := walk(router)
	routes := []route{}
	for _, pattern := range order {
		got := methods[pattern]
		for m := range got {
			if answered := matched(router, m, sample(pattern)); answered != pattern {
				panic(fmt.Sprintf("%s %s is matched to %q, not to %q that registers it", m, sample(pattern), answered, pattern))
			}
		}
		any := true
		for m := range all["/"] {
			any = any && got[m]
		}
		var ms []string
		if any {
			ms = []string{"*"}
		} else {
			for m := range got {
				ms = append(ms, m)
			}
			sort.Strings(ms)
		}
		for _, m := range ms {
			request := m
			if m == "*" {
				request = http.MethodPatch
			}
			routes = append(routes, route{Method: m, Path: canonical(pattern), Raw: pattern})
			// A wildcard chi also dispatches with nothing after its `/` serves the path before that `/` as well; Mount
			// registers that path on its own beside the wildcard, for the same handler.
			if parent := strings.TrimSuffix(pattern, "*"); parent != pattern {
				if found := matched(router, request, sample(parent)); found == pattern || found == parent {
					routes = append(routes, route{Method: m, Path: canonical(parent), Raw: parent})
				}
			}
		}
	}

	version := ""
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == "github.com/go-chi/chi/v5" {
				version = strings.TrimPrefix(dep.Version, "v")
			}
		}
	}
	json.NewEncoder(os.Stdout).Encode(map[string]any{"framework": "chi", "version": version, "routes": routes})
}
