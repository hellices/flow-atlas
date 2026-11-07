//go:build ignore

// Asks go-zero which routes the application serves: the application registers its routes as goctl generated them
// from items.api (internal/handler/routes.go, `server.AddRoutes` with `rest.WithPrefix`), and Server.Routes() returns
// them as the server binds them, prefixes applied. go-zero binds them to its router only when the server starts
// listening, so each route is bound here the same way to go-zero's own router (rest/router.NewRouter, which the server
// dispatches with) and requested through it, and the router must dispatch the request to that route's handler.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"runtime/debug"
	"strconv"
	"strings"

	"github.com/zeromicro/go-zero/core/conf"
	"github.com/zeromicro/go-zero/core/logx"
	"github.com/zeromicro/go-zero/rest"
	"github.com/zeromicro/go-zero/rest/router"

	"example.com/gozeroroutes/internal/config"
	"example.com/gozeroroutes/internal/handler"
	"example.com/gozeroroutes/internal/svc"
)

type route struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Raw    string `json:"raw"`
}

var param = regexp.MustCompile(`:[^/]+`)

func main() {
	logx.SetWriter(logx.NewWriter(os.Stderr))
	logx.Disable()

	var c config.Config
	conf.MustLoad("etc/items-api.yaml", &c)
	server := rest.MustNewServer(c.RestConf)
	handler.RegisterHandlers(server, svc.NewServiceContext(c))

	registered := server.Routes()
	dispatcher := router.NewRouter()
	for i, r := range registered {
		index := strconv.Itoa(i)
		if err := dispatcher.Handle(r.Method, r.Path, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			io.WriteString(w, index)
		})); err != nil {
			panic(fmt.Sprintf("go-zero does not take %s %s: %v", r.Method, r.Path, err))
		}
	}

	routes := []route{}
	for i, r := range registered {
		sample := param.ReplaceAllString(r.Path, "value1")
		w := httptest.NewRecorder()
		dispatcher.ServeHTTP(w, httptest.NewRequest(r.Method, sample, nil))
		if w.Body.String() != strconv.Itoa(i) {
			panic(fmt.Sprintf("%s %s is not dispatched to %s %s that registers it", r.Method, sample, r.Method, r.Path))
		}
		path := strings.TrimRight(param.ReplaceAllString(r.Path, "{}"), "/")
		if path == "" {
			path = "/"
		}
		routes = append(routes, route{Method: r.Method, Path: path, Raw: r.Path})
	}

	version := ""
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == "github.com/zeromicro/go-zero" {
				version = strings.TrimPrefix(dep.Version, "v")
			}
		}
	}
	json.NewEncoder(os.Stdout).Encode(map[string]any{"framework": "go-zero", "version": version, "routes": routes})
}
