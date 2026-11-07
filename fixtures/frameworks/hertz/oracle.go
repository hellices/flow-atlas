// Asks Hertz which routes the application serves: Engine.Routes() walks the method trees Hertz dispatches requests
// with, so each entry is a route the application serves. Each route is then requested through the engine (Hertz's own
// ut.PerformRequest, no network), and Hertz's account of the route it matched (RequestContext.FullPath) must be that
// route; a catch-all `*name` is also requested with nothing after its `/`, to learn whether Hertz dispatches that path
// to it as well.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"runtime/debug"
	"sort"
	"strings"

	"github.com/cloudwego/hertz/pkg/app"
	"github.com/cloudwego/hertz/pkg/app/server"
	"github.com/cloudwego/hertz/pkg/common/hlog"
	"github.com/cloudwego/hertz/pkg/common/ut"
	"github.com/cloudwego/hertz/pkg/protocol/consts"
	"github.com/cloudwego/hertz/pkg/route"

	application "example.com/hertzroutes/app"
)

type entry struct {
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

// matched is the route Hertz reported for the request it last dispatched.
var matched string

// answers is the route Hertz dispatches the request to, as it reports it.
func answers(engine *route.Engine, method, path string) string {
	matched = ""
	ut.PerformRequest(engine, method, path, nil, ut.Header{Key: "Authorization", Value: "Basic dGVzdDp0ZXN0"})
	return matched
}

func main() {
	hlog.SetOutput(os.Stderr)

	// The methods `Any` registers, as Hertz itself registers them: a path holding all of them takes any method.
	probe := server.New(server.WithDisablePrintRoute(true))
	probe.Any("/", func(context.Context, *app.RequestContext) {})
	var every []string
	for _, r := range probe.Routes() {
		every = append(every, r.Method)
	}

	h := server.New(server.WithDisablePrintRoute(true))
	h.Use(func(ctx context.Context, c *app.RequestContext) {
		matched = c.FullPath()
		c.Next(ctx)
	})
	application.Register(h)

	methods := map[[2]string]map[string]bool{}
	var order [][2]string
	for _, r := range h.Routes() {
		key := [2]string{r.Path, r.Handler}
		if methods[key] == nil {
			methods[key] = map[string]bool{}
			order = append(order, key)
		}
		methods[key][r.Method] = true
	}

	routes := []entry{}
	for _, key := range order {
		raw, got := key[0], methods[key]
		for m := range got {
			if answered := answers(h.Engine, m, sample(raw)); answered != raw {
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
				request = consts.MethodPatch
			}
			routes = append(routes, entry{Method: m, Path: canonical(raw), Raw: raw})
			// A catch-all Hertz also dispatches with nothing after its `/` serves the path before that `/` as well.
			if parent := wild.ReplaceAllString(raw, ""); parent != raw && answers(h.Engine, request, sample(parent)) == raw {
				routes = append(routes, entry{Method: m, Path: canonical(parent), Raw: parent})
			}
		}
	}

	version := ""
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == "github.com/cloudwego/hertz" {
				version = strings.TrimPrefix(dep.Version, "v")
			}
		}
	}
	json.NewEncoder(os.Stdout).Encode(map[string]any{"framework": "hertz", "version": version, "routes": routes})
}
