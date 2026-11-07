// Asks Fiber which routes the application serves: App.GetRoutes(true) is the stack of routes Fiber dispatches requests
// with, those of mounted sub-apps under their prefix included, without the middleware Use and RouteChain's All add.
// Each route is then requested through App.Test, and Fiber's own account of the route that handled the request
// (Ctx.Route, read by a middleware after the chain) must be that route. The request path is built by Route.URL,
// Fiber's own reading of the pattern (lowercased, as Fiber matches paths ignoring case), with values Fiber's
// constraints decide between; each parameter is also given
// several segments and nothing, to learn which paths Fiber dispatches to the route: a parameter that takes several
// segments is `{**}`, and one that takes nothing serves the path without it.
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime/debug"
	"sort"
	"strings"

	"github.com/gofiber/fiber/v3"

	"example.com/fiberroutes/app"
)

type route struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Raw    string `json:"raw"`
}

// Values a parameter is given, one segment each, among which a route's constraints choose.
var values = []string{"value1", "12345", "2024-01-02", "CD2C1638-1638-72D5-1638-DEADBEEF1638"}

const rest = "rest/of/it"

func marker(i int) string { return fmt.Sprintf("zq%dqz", i) }

// answered is the route Fiber dispatches the request to, as it reports it.
func answered(a *fiber.App, method, path string) string {
	resp, err := a.Test(httptest.NewRequest(method, path, nil))
	if err != nil {
		panic(fmt.Sprintf("%s %s: %v", method, path, err))
	}
	return resp.Header.Get("X-Route")
}

// served is each path, in the canonical form, that Fiber dispatches to the route for the method.
func served(a *fiber.App, r fiber.Route) []string {
	named := fiber.Map{}
	for i, p := range r.Params {
		named[p] = marker(i)
	}
	template, err := r.URL(named)
	if err != nil {
		panic(fmt.Sprintf("%s %s: %v", r.Method, r.Path, err))
	}
	fill := func(given []string) string {
		path := template
		for i, v := range given {
			path = strings.Replace(path, marker(i), v, 1)
		}
		return path
	}
	serves := func(given []string) bool { return answered(a, r.Method, fill(given)) == r.Method+" "+r.Path }

	// The first values, one segment each, that Fiber dispatches to the route.
	var base []string
	var search func(given []string) bool
	search = func(given []string) bool {
		if len(given) == len(r.Params) {
			if serves(given) {
				base = given
				return true
			}
			return false
		}
		for _, v := range values {
			if search(append(append([]string{}, given...), v)) {
				return true
			}
		}
		return false
	}
	if !search(nil) {
		panic(fmt.Sprintf("%s %s: no request the oracle makes is dispatched to it", r.Method, r.Path))
	}

	canonical := func(path string) string {
		if path = strings.TrimRight(path, "/"); path == "" {
			return "/"
		}
		return path
	}
	kinds := make([]string, len(r.Params))
	var empty []int
	for i := range r.Params {
		kinds[i] = "{}"
		with := func(v string) []string { g := append([]string{}, base...); g[i] = v; return g }
		if serves(with(rest)) {
			if !strings.HasSuffix(template, "/"+marker(i)) {
				panic(fmt.Sprintf("%s %s: a parameter that takes several segments within the path cannot be written", r.Method, r.Path))
			}
			kinds[i] = "{**}"
		}
		if serves(with("")) {
			empty = append(empty, i)
		}
	}
	paths := []string{canonical(fill(kinds))}
	for _, i := range empty {
		without := append([]string{}, kinds...)
		without[i] = ""
		if !strings.HasSuffix(template, "/"+marker(i)) {
			panic(fmt.Sprintf("%s %s: a parameter that takes nothing within the path cannot be written", r.Method, r.Path))
		}
		paths = append(paths, canonical(fill(without)))
	}
	return paths
}

func main() {
	// The methods All registers, as Fiber itself registers them: a path holding all of them takes any method.
	probe := fiber.New()
	probe.All("/", func(fiber.Ctx) error { return nil })
	every := map[string]bool{}
	for _, r := range probe.GetRoutes(true) {
		every[r.Method] = true
	}

	a := fiber.New()
	a.Use(func(c fiber.Ctx) error {
		err := c.Next()
		c.Set("X-Route", c.Route().Method+" "+c.Route().Path)
		return err
	})
	app.Register(a)
	answered(a, http.MethodGet, "/") // the first request mounts the sub-apps' routes into the app's stack

	type key struct{ path, raw string }
	methods := map[key]map[string]bool{}
	var order []key
	for _, r := range a.GetRoutes(true) {
		for _, path := range served(a, r) {
			k := key{path, r.Path}
			if methods[k] == nil {
				methods[k] = map[string]bool{}
				order = append(order, k)
			}
			methods[k][r.Method] = true
		}
	}
	routes := []route{}
	for _, k := range order {
		any := true
		for m := range every {
			any = any && methods[k][m]
		}
		if any {
			routes = append(routes, route{Method: "*", Path: k.path, Raw: k.raw})
			continue
		}
		var ms []string
		for m := range methods[k] {
			ms = append(ms, m)
		}
		sort.Strings(ms)
		for _, m := range ms {
			routes = append(routes, route{Method: m, Path: k.path, Raw: k.raw})
		}
	}

	version := ""
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == "github.com/gofiber/fiber/v3" {
				version = strings.TrimPrefix(dep.Version, "v")
			}
		}
	}
	json.NewEncoder(os.Stdout).Encode(map[string]any{"framework": "fiber", "version": version, "routes": routes})
}
