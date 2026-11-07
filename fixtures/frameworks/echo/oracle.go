// Asks Echo which routes the application serves: the Router's Routes() is the table of routes Echo's router added to
// the tree it dispatches requests with. Each route is then looked up with Router.Route, Echo's own lookup, which must
// report that route (Context.RouteInfo); a route for any method (Any) is looked up with a method Echo does not know.
// Each route is also looked up with more segments after it, and a `/*` wildcard with one segment, several and nothing
// after its `/`, to learn which of these paths Echo dispatches to it: a parameter that ends a route takes the rest of
// the path where no route continues below it, and a wildcard beside such a parameter is left only the empty rest. The 404 routes (Echo's RouteNotFound, which a group with middleware adds for itself) are left out: they
// answer a path no route serves.
package main

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"regexp"
	"runtime/debug"
	"strings"

	"github.com/labstack/echo/v5"

	"example.com/echoroutes/app"
)

type route struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Raw    string `json:"raw"`
}

// A `:name` parameter runs to the end of its segment; a `*` wildcard takes the rest of the path.
var param = regexp.MustCompile(`:[^/]+`)

func canonical(path string) string {
	path = param.ReplaceAllString(path, "{}")
	if strings.HasSuffix(path, "/*") {
		path = strings.TrimSuffix(path, "*") + "{**}"
	} else if strings.Contains(path, "*") {
		panic("a wildcard not after a `/` also takes the rest of a segment, which the canonical form cannot write: " + path)
	}
	if path = strings.TrimRight(path, "/"); path == "" {
		return "/"
	}
	return path
}

func sample(path string) string {
	path = param.ReplaceAllString(path, "value1")
	if strings.HasSuffix(path, "*") {
		path = strings.TrimSuffix(path, "*") + "rest/of/it"
	}
	return path
}

// matched is the route Echo's router dispatches the request to, as it reports it.
func matched(e *echo.Echo, method, path string) echo.RouteInfo {
	c := e.NewContext(httptest.NewRequest(method, path, nil), httptest.NewRecorder())
	e.Router().Route(c)
	return c.RouteInfo()
}

func main() {
	e := app.New()
	routes := []route{}
	for _, ri := range e.Router().Routes() {
		if ri.Method == echo.RouteNotFound {
			continue
		}
		method, request := ri.Method, ri.Method
		if ri.Method == echo.RouteAny {
			method, request = "*", "PURGE"
		}
		serves := func(path string) bool {
			got := matched(e, request, path)
			return got.Method == ri.Method && got.Path == ri.Path
		}
		add := func(path string) { routes = append(routes, route{Method: method, Path: path, Raw: ri.Path}) }
		if parent, found := strings.CutSuffix(ri.Path, "*"); found {
			// A wildcard takes the rest of the path, unless a route beside it takes that path first: a path the
			// router dispatches to it with one segment or more after its `/` is `{**}`, with nothing after it the
			// path before that `/`.
			one, more := serves(sample(parent)+"value1"), serves(sample(parent)+"rest/of/it")
			if one != more {
				panic(fmt.Sprintf("%s %s takes one segment after its `/` or more, not both", request, ri.Path))
			}
			if one {
				add(canonical(ri.Path))
			}
			if serves(sample(parent)) {
				add(canonical(parent))
			}
			if !one && !serves(sample(parent)) {
				panic(fmt.Sprintf("%s %s serves no path the oracle asks for", request, ri.Path))
			}
			continue
		}
		if !serves(sample(ri.Path)) {
			got := matched(e, request, sample(ri.Path))
			panic(fmt.Sprintf("%s %s is dispatched to %s %q, not to %s %q that registers it", request, sample(ri.Path), got.Method, got.Path, ri.Method, ri.Path))
		}
		add(canonical(ri.Path))
		// A parameter that ends the route takes the rest of the path, slashes included, where no route continues
		// below it in the tree: the router dispatches more segments after the route to the route itself.
		if serves(sample(ri.Path) + "/rest/of/it") {
			add(canonical(ri.Path) + "/{**}")
		}
	}

	version := ""
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == "github.com/labstack/echo/v5" {
				version = strings.TrimPrefix(dep.Version, "v")
			}
		}
	}
	json.NewEncoder(os.Stdout).Encode(map[string]any{"framework": "echo", "version": version, "routes": routes})
}
