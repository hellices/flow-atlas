// Asks Gin which routes the application serves: Engine.Routes() walks the method trees Gin dispatches requests with,
// so each entry is a route the application serves. Each route is then requested through the engine, and Gin's own
// account of the route it matched (Context.FullPath) must be that route; a catch-all `*name` is also requested with
// nothing after its `/`, to learn whether Gin dispatches that path to it as well.
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

	version := ""
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == "github.com/gin-gonic/gin" {
				version = strings.TrimPrefix(dep.Version, "v")
			}
		}
	}
	if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"framework": "gin", "version": version, "routes": routes}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
