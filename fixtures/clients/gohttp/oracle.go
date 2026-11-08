// Makes every request the app's code makes with net/http, once. The users package reads the service's URL from the
// environment (USERS_API_URL, which client.yaml sets to the recording server's URL); the billing client is built as
// the app builds it, with that URL. Each exported function of the users package (checked against the package's source)
// and each exported method of the billing client is called with ARG for a string argument, ARG_NUMBER for a number, a
// background context, and an empty value for anything else. Every call must return without an error.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"reflect"
	"runtime"
	"slices"
	"strconv"
	"strings"

	"example.com/gohttpcalls/billing"
	"example.com/gohttpcalls/users"
)

var usersFuncs = map[string]any{
	"Health":  users.Health,
	"Get":     users.Get,
	"Search":  users.Search,
	"Create":  users.Create,
	"Login":   users.Login,
	"Replace": users.Replace,
	"Rename":  users.Rename,
	"Delete":  users.Delete,
	"Report":  users.Report,
}

func main() {
	for _, name := range exportedFuncs("users") {
		if _, ok := usersFuncs[name]; !ok {
			fail("users.%s is not called", name)
		}
	}
	names := make([]string, 0, len(usersFuncs))
	for name := range usersFuncs {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		call("users."+name, reflect.ValueOf(usersFuncs[name]))
	}

	client, err := billing.NewClient(os.Getenv("RECORD_URL"), nil)
	if err != nil {
		fail("billing.NewClient: %v", err)
	}
	v := reflect.ValueOf(client)
	for i := 0; i < v.NumMethod(); i++ {
		call("billing.Client."+v.Type().Method(i).Name, v.Method(i))
	}

	json.NewEncoder(os.Stdout).Encode(map[string]string{"library": "net/http", "version": strings.TrimPrefix(runtime.Version(), "go")})
}

// exportedFuncs lists the exported functions (not methods) a package's source declares.
func exportedFuncs(dir string) []string {
	pkgs, err := parser.ParseDir(token.NewFileSet(), dir, nil, 0)
	if err != nil {
		fail("%s: %v", dir, err)
	}
	var names []string
	for _, pkg := range pkgs {
		for _, file := range pkg.Files {
			for _, decl := range file.Decls {
				if fn, ok := decl.(*ast.FuncDecl); ok && fn.Recv == nil && fn.Name.IsExported() {
					names = append(names, fn.Name.Name)
				}
			}
		}
	}
	return names
}

var contextType = reflect.TypeOf((*context.Context)(nil)).Elem()

func call(name string, fn reflect.Value) {
	number, err := strconv.Atoi(os.Getenv("ARG_NUMBER"))
	if err != nil {
		fail("ARG_NUMBER: %v", err)
	}
	args := make([]reflect.Value, fn.Type().NumIn())
	for i := range args {
		t := fn.Type().In(i)
		switch {
		case t == contextType:
			args[i] = reflect.ValueOf(context.Background())
		case t.Kind() == reflect.String:
			args[i] = reflect.ValueOf(os.Getenv("ARG")).Convert(t)
		case t.Kind() == reflect.Int || t.Kind() == reflect.Int64:
			args[i] = reflect.ValueOf(number).Convert(t)
		case t.Kind() == reflect.Pointer:
			args[i] = reflect.New(t.Elem())
		default:
			args[i] = reflect.Zero(t)
		}
	}
	for _, out := range fn.Call(args) {
		if e, ok := out.Interface().(error); ok && e != nil {
			fail("%s: %v", name, e)
		}
	}
}

func fail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", a...)
	os.Exit(1)
}
