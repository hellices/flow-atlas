// Asks Beego which routes the application serves. PrintTree, the route table Beego documents (and its admin page
// shows), lists each method's routing tree, the trees Beego dispatches requests with. A controller registered without
// a method mapping sits in every method's tree, though only the methods it writes are its own: web.Controller answers
// the others with 405 (TRACE excepted, which it echoes), and Beego fails with a 500 on a method it has no function
// for. So each method and route is requested through Beego's handler, and counts when Beego reports that route as
// the one it matched (the `RouterPattern` it stores on the request) and answers below 400. A route whose last segment
// is a parameter or `*` is also requested with two segments there, to learn whether Beego matches the rest of the
// path with it, and with nothing after its last `/`, to learn whether Beego dispatches that path to it as well; any
// other route is requested with two more segments, to learn whether it takes the rest of the path (web.Handler's
// mounted handler does, though the tree lists it under its own path). Static directories
// (BConfig.WebConfig.StaticDir, the default `/static` among them) are not in the trees: Beego serves them before
// routing, so each is confirmed by a request for a file in it.
package main

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"sort"
	"strings"

	"github.com/beego/beego/v2/core/logs"
	"github.com/beego/beego/v2/server/web"
	"github.com/beego/beego/v2/server/web/context"

	_ "example.com/beegoroutes/routers"
)

type route struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Raw    string `json:"raw"`
}

// param is a Beego parameter within a segment: `:name`, optionally typed (`:name:int`) or with a regular expression
// (`:name([0-9]+)`), and `?` before it when it is optional.
var param = regexp.MustCompile(`\??:\w+(?::int|:string)?(?:\([^)]*\))?`)

// matched is the route Beego reported for the request it last dispatched.
var matched string

func answers(method, path string) (string, int) {
	matched = ""
	w := httptest.NewRecorder()
	web.BeeApp.Handlers.ServeHTTP(w, httptest.NewRequest(method, path, nil))
	return matched, w.Code
}

// serves reports whether Beego dispatches the request to the pattern's own handler and that handler answers it: not
// web.Controller's 405 for a method the controller does not write, nor a 500 for one Beego finds no function for.
func serves(method, path, pattern string) bool {
	got, code := answers(method, path)
	return got == pattern && code < http.StatusBadRequest
}

// sample is a path the pattern matches, its last parameter or `*` replaced by last.
func sample(segments []string, last string) string {
	out := make([]string, len(segments))
	for i, seg := range segments {
		value := "1"
		if i == len(segments)-1 {
			value = last
		}
		if seg == "*" {
			out[i] = value
		} else {
			out[i] = param.ReplaceAllString(seg, value)
		}
	}
	return join(out)
}

// join writes the segments as a path without a trailing `/`; Beego keeps a pattern registered without its leading `/`
// as it is given.
func join(segments []string) string {
	if p := strings.Trim(strings.Join(segments, "/"), "/"); p != "" {
		return "/" + p
	}
	return "/"
}

func main() {
	// Beego's console log writes to stdout; the routes go there, the log to stderr.
	stdout := os.Stdout
	os.Stdout = os.Stderr
	logs.Reset()
	logs.SetLogger(logs.AdapterConsole)

	web.InsertFilter("*", web.BeforeExec, func(ctx *context.Context) {
		if p, ok := ctx.Input.GetData("RouterPattern").(string); ok {
			matched = p
		}
	}, web.WithReturnOnOutput(false))
	web.BeeApp.Handlers.Init()

	var every []string
	for m := range web.HTTPMETHOD {
		every = append(every, m)
	}
	sort.Strings(every)

	tree := web.BeeApp.PrintTree()
	data := tree["Data"].(web.M)
	served := map[string]map[string]bool{}
	var patterns []string
	for _, method := range every {
		list, ok := data[method].(*[][]string)
		if !ok {
			continue
		}
		for _, entry := range *list {
			pattern := entry[0]
			segments := strings.Split(pattern, "/")
			for i, seg := range segments {
				lastStar := seg == "*" && i == len(segments)-1
				if (strings.Contains(seg, "*") && !lastStar) || (strings.Contains(seg, "?") && !strings.HasPrefix(seg, "?:")) {
					panic(fmt.Sprintf("%s has a segment the canonical form cannot express: %q", pattern, seg))
				}
			}
			if served[pattern] == nil {
				served[pattern] = map[string]bool{}
				patterns = append(patterns, pattern)
			}
			if serves(method, sample(segments, "1"), pattern) {
				served[pattern][method] = true
			}
		}
	}

	routes := []route{}
	for _, pattern := range patterns {
		got := served[pattern]
		// A route in the trees that answers no method was not reached by its sample (a parameter's expression may not
		// match `1`), so it would be left out without a word.
		if len(got) == 0 {
			panic(fmt.Sprintf("%s answers no method at %s", pattern, sample(strings.Split(pattern, "/"), "1")))
		}
		segments := strings.Split(pattern, "/")
		last := segments[len(segments)-1]
		var ms []string
		all := true
		for _, m := range every {
			all = all && got[m]
		}
		if all {
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
			canonical := make([]string, len(segments))
			for i, seg := range segments {
				canonical[i] = param.ReplaceAllString(seg, "{}")
			}
			dynamic := last == "*" || param.MatchString(last)
			// A last parameter Beego matches with more than one segment takes the rest of the path.
			if dynamic && serves(request, sample(segments, "1/2"), pattern) {
				canonical[len(canonical)-1] = "{**}"
			} else if last == "*" {
				panic(pattern + " does not take two segments for its `*`")
			}
			routes = append(routes, route{Method: m, Path: join(canonical), Raw: pattern})
			// A route Beego dispatches with more segments after it (a mounted handler's) takes the rest of the path too.
			if !dynamic && serves(request, join(append(append([]string{}, segments...), "1", "2")), pattern) {
				routes = append(routes, route{Method: m, Path: join(append(canonical, "{**}")), Raw: pattern})
			}
			// A route Beego also dispatches with nothing after its last `/` serves the path before that `/` as well.
			parent := join(segments[:len(segments)-1])
			if dynamic && serves(request, strings.TrimSuffix(parent, "/")+"/", pattern) {
				routes = append(routes, route{Method: m, Path: join(canonical[:len(canonical)-1]), Raw: pattern})
			}
		}
	}

	// Static directories: a file in each is requested, and Beego must serve it before routing (no route matched).
	for prefix, dir := range web.BConfig.WebConfig.StaticDir {
		var file string
		filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err == nil && !d.IsDir() && file == "" {
				file = path
			}
			return nil
		})
		if file == "" {
			continue
		}
		rel, _ := filepath.Rel(dir, file)
		body, _ := os.ReadFile(file)
		for _, m := range []string{http.MethodGet, http.MethodHead} {
			matched = ""
			w := httptest.NewRecorder()
			web.BeeApp.Handlers.ServeHTTP(w, httptest.NewRequest(m, prefix+"/"+filepath.ToSlash(rel), nil))
			if matched != "" || w.Code != http.StatusOK || (m == http.MethodGet && w.Body.String() != string(body)) {
				panic(fmt.Sprintf("%s %s/%s is not served from %s", m, prefix, rel, dir))
			}
			path := strings.TrimSuffix(prefix, "/") + "/{**}"
			routes = append(routes, route{Method: m, Path: path, Raw: prefix + " -> " + dir})
		}
	}

	version := ""
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == "github.com/beego/beego/v2" {
				version = strings.TrimPrefix(dep.Version, "v")
			}
		}
	}
	json.NewEncoder(stdout).Encode(map[string]any{"framework": "beego", "version": version, "routes": routes})
}
