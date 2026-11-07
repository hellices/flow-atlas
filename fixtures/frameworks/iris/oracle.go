// Asks Iris which routes the application serves: Application.GetRoutes() is the route table Iris builds its router
// from, each route with its method, its path as Iris's router holds it (`:name` a segment, `*name` the rest) and its
// template as written. Offline routes (`None`) are left out: Iris serves them only to Context.Exec. Each route is then
// requested through the application with values its parameters' macros accept, and Iris's account of the route it
// matched (Context.GetCurrentRoute) must be that route; a `path` wildcard is also requested with nothing after its
// `/`, following Iris's path correction, to learn whether Iris dispatches that path to it as well.
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

	"github.com/kataras/iris/v12"
	"github.com/kataras/iris/v12/core/router"

	"example.com/irisroutes/app"
)

type route struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Raw    string `json:"raw"`
}

var (
	param = regexp.MustCompile(`:[^/]+`)
	wild  = regexp.MustCompile(`\*[^/]+$`)
)

// candidates are values for a `:name` segment, one of which each parameter type's macro accepts: a number, a negative
// one, letters, letters and digits, a file name, a UUID.
var candidates = []string{"1", "-1", "abcd", "abc123", "abc.xml", "123e4567-e89b-12d3-a456-426614174000"}

// canonical writes a `:name` segment as `{}` and a `*name` wildcard, which takes the rest of the path, as `{**}`.
func canonical(path string) string {
	path = wild.ReplaceAllString(param.ReplaceAllString(path, "{}"), "{**}")
	if path = strings.TrimRight(path, "/"); path == "" {
		return "/"
	}
	return path
}

// samples are the paths the route's path stands for with each combination of candidate values.
func samples(path string) []string {
	path = wild.ReplaceAllString(path, "rest/of/it")
	out := []string{path}
	for param.MatchString(out[0]) {
		var next []string
		for _, p := range out {
			loc := param.FindStringIndex(p)
			for _, c := range candidates {
				next = append(next, p[:loc[0]]+c+p[loc[1]:])
			}
		}
		out = next
	}
	return out
}

// matched is the route Iris reported for the request it last dispatched.
var matched string

// answers is the route Iris dispatches the request to, following one redirect of its path correction.
func answers(application *iris.Application, method, path string) string {
	matched = ""
	w := httptest.NewRecorder()
	application.ServeHTTP(w, httptest.NewRequest(method, path, nil))
	if location := w.Header().Get("Location"); matched == "" && w.Code >= 300 && w.Code < 400 && location != "" {
		matched = ""
		application.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(method, location, nil))
	}
	return matched
}

func main() {
	// The methods `Any` registers, as Iris itself registers them: a path holding all of them takes any method.
	var every []string
	for _, m := range router.AllMethods {
		every = append(every, m)
	}

	application := iris.New()
	application.Logger().SetOutput(os.Stderr)
	application.Logger().SetLevel("disable")
	application.UseGlobal(func(ctx iris.Context) {
		matched = ctx.GetCurrentRoute().Name()
		ctx.Next()
	})
	app.Register(application)
	if err := application.Build(); err != nil {
		panic(err)
	}

	methods := map[string]map[string]*router.Route{}
	var order []string
	for _, r := range application.GetRoutes() {
		if !r.IsOnline() {
			continue
		}
		key := r.Tmpl().Src
		if methods[key] == nil {
			methods[key] = map[string]*router.Route{}
			order = append(order, key)
		}
		methods[key][r.Method] = r
	}

	routes := []route{}
	for _, key := range order {
		got := methods[key]
		var path string
		for m, r := range got {
			path = r.Path
			confirmed := false
			for _, s := range samples(r.Path) {
				if answers(application, m, s) == r.Name {
					confirmed = true
					break
				}
			}
			if !confirmed {
				panic(fmt.Sprintf("no request for %s %s is answered by that route", m, key))
			}
		}
		any := true
		for _, m := range every {
			any = any && got[m] != nil
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
			request, name := m, ""
			if m == "*" {
				request = http.MethodPatch
			}
			name = got[request].Name
			routes = append(routes, route{Method: m, Path: canonical(path), Raw: key})
			// A wildcard Iris also dispatches with nothing after its `/` serves the path before that `/` as well.
			if parent := wild.ReplaceAllString(path, ""); parent != path {
				for _, s := range samples(parent) {
					if answers(application, request, s) == name {
						routes = append(routes, route{Method: m, Path: canonical(parent), Raw: key})
						break
					}
				}
			}
		}
	}

	version := ""
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == "github.com/kataras/iris/v12" {
				version = strings.TrimPrefix(dep.Version, "v")
			}
		}
	}
	json.NewEncoder(os.Stdout).Encode(map[string]any{"framework": "iris", "version": version, "routes": routes})
}
