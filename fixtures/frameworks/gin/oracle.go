// Asks Gin which routes the application serves: Engine.Routes() walks the method trees Gin dispatches requests with,
// so each entry is a route the application serves. Each route is then requested through the engine, and Gin's own
// account of the route it matched (Context.FullPath) must be that route; a catch-all `*name` is also requested with
// nothing after its `/`, to learn whether Gin dispatches that path to it as well. Last, sample requests are sent through
// the engine and each recorded with the route Gin dispatched it to, by the same account.
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

	"github.com/gin-gonic/gin"

	"example.com/ginroutes/app"
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

// canonical writes a `:name` segment as `{}` and a `*name` catch-all, which takes the rest of the path, as `{**}`.
func canonical(path string) string {
	path = wild.ReplaceAllString(param.ReplaceAllString(path, "{}"), "{**}")
	if path = strings.TrimRight(path, "/"); path == "" {
		return "/"
	}
	return path
}

func sample(path string) string {
	return wild.ReplaceAllString(param.ReplaceAllString(path, "value1"), "rest/of/it")
}

// answers is the route Gin dispatches the request to, as it reports it.
func answers(engine *gin.Engine, method, path string) string {
	w := httptest.NewRecorder()
	engine.ServeHTTP(w, httptest.NewRequest(method, path, nil))
	return w.Header().Get("X-Route")
}

type request struct {
	Method string  `json:"method"`
	Path   string  `json:"path"`
	Route  *string `json:"route"`
}

// dispatched is the route Gin dispatches the request to, as it reports it, and the value of its catch-all, if any.
// Gin answers a path that only matches with (without) a trailing `/` with a redirect to the path a route takes
// (RedirectTrailingSlash, on by default: "the client is redirected to /foo"), so the request is the redirect target's.
func dispatched(engine *gin.Engine, method, path string) (string, string) {
	w := httptest.NewRecorder()
	engine.ServeHTTP(w, httptest.NewRequest(method, path, nil))
	if route := w.Header().Get("X-Route"); route != "" {
		return route, w.Header().Get("X-Rest")
	}
	if w.Code == http.StatusMovedPermanently || w.Code == http.StatusTemporaryRedirect {
		if to := w.Header().Get("Location"); to != path && strings.TrimRight(to, "/") == strings.TrimRight(path, "/") {
			return dispatched(engine, method, to)
		}
	}
	return "", ""
}

func main() {
	gin.SetMode(gin.ReleaseMode)
	gin.DefaultWriter = os.Stderr

	// The methods `Any` registers, as Gin itself registers them: a path holding all of them takes any method.
	probe := gin.New()
	probe.Any("/", func(*gin.Context) {})
	var every []string
	for _, r := range probe.Routes() {
		every = append(every, r.Method)
	}

	engine := gin.New()
	engine.Use(func(c *gin.Context) {
		c.Header("X-Route", c.FullPath())
		if rest := wild.FindString(c.FullPath()); rest != "" {
			c.Header("X-Rest", c.Param(rest[1:]))
		}
		c.Next()
	})
	app.Register(engine)

	methods := map[[2]string]map[string]bool{}
	var order [][2]string
	for _, r := range engine.Routes() {
		key := [2]string{r.Path, r.Handler}
		if methods[key] == nil {
			methods[key] = map[string]bool{}
			order = append(order, key)
		}
		methods[key][r.Method] = true
	}

	routes := []route{}
	for _, key := range order {
		raw, got := key[0], methods[key]
		for m := range got {
			if answered := answers(engine, m, sample(raw)); answered != raw {
				panic(fmt.Sprintf("%s %s is answered by route %q, not by %q that registers it", m, sample(raw), answered, raw))
			}
		}
		any := true
		for _, m := range every {
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
			routes = append(routes, route{Method: m, Path: canonical(raw), Raw: raw})
			// A catch-all Gin also dispatches with nothing after its `/` serves the path before that `/` as well.
			if parent := wild.ReplaceAllString(raw, ""); parent != raw && answers(engine, request, sample(parent)) == raw {
				routes = append(routes, route{Method: m, Path: canonical(parent), Raw: parent})
			}
		}
	}

	// Sample requests: every route's sample path, also with a trailing `/`, and a path no route takes, each with every
	// method a route registers. A catch-all that took the request with nothing after its `/` is its parent's route.
	anyMethod := map[string]bool{}
	var registered []string
	samples := map[string]bool{"/nowhere/value1": true}
	for _, r := range routes {
		if r.Method == "*" {
			anyMethod[r.Raw] = true
		} else if r.Method != http.MethodHead && r.Method != http.MethodOptions && !contains(registered, r.Method) {
			registered = append(registered, r.Method)
		}
		s := strings.TrimRight(sample(r.Raw), "/")
		if s == "" {
			s = "/"
		}
		samples[s] = true
		if s != "/" {
			samples[s+"/"] = true
		}
	}
	sort.Strings(registered)
	var probes []string
	for p := range samples {
		probes = append(probes, p)
	}
	sort.Strings(probes)
	requests := []request{}
	for _, path := range probes {
		for _, m := range registered {
			raw, rest := dispatched(engine, m, path)
			if raw == "" {
				requests = append(requests, request{Method: m, Path: path, Route: nil})
				continue
			}
			key := raw
			if rest == "/" || (rest == "" && wild.MatchString(raw)) {
				key = wild.ReplaceAllString(raw, "")
			}
			method := m
			if anyMethod[raw] {
				method = "*"
			}
			route := method + " " + canonical(key)
			requests = append(requests, request{Method: m, Path: path, Route: &route})
		}
	}

	version := ""
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == "github.com/gin-gonic/gin" {
				version = strings.TrimPrefix(dep.Version, "v")
			}
		}
	}
	json.NewEncoder(os.Stdout).Encode(map[string]any{"framework": "gin", "version": version, "routes": routes, "requests": requests})
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
