// Makes every request the app's resty clients make, once: each client is built as the app builds it, with the recording
// server's URL as its configured base URL, and each of its exported methods is called with ARG for a string argument,
// ARG_NUMBER for a number and a zero value for anything else. Every method must return without an error.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"runtime/debug"
	"strconv"
	"strings"

	"example.com/restycalls/api"
)

func main() {
	base := os.Getenv("RECORD_URL")
	for _, client := range []any{api.NewUsers(base, "token"), api.NewBilling(base)} {
		callAll(client)
	}
	version := ""
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == "github.com/go-resty/resty/v2" {
				version = strings.TrimPrefix(dep.Version, "v")
			}
		}
	}
	if err := json.NewEncoder(os.Stdout).Encode(map[string]string{"library": "resty", "version": version}); err != nil {
		fail("%v", err)
	}
}

func callAll(client any) {
	arg := os.Getenv("ARG")
	number, err := strconv.Atoi(os.Getenv("ARG_NUMBER"))
	if err != nil {
		fail("ARG_NUMBER: %v", err)
	}
	v := reflect.ValueOf(client)
	for i := 0; i < v.NumMethod(); i++ {
		name := v.Type().Method(i).Name
		method := v.Method(i)
		args := make([]reflect.Value, method.Type().NumIn())
		for j := range args {
			t := method.Type().In(j)
			switch t.Kind() {
			case reflect.String:
				args[j] = reflect.ValueOf(arg).Convert(t)
			case reflect.Int, reflect.Int64:
				args[j] = reflect.ValueOf(number).Convert(t)
			default:
				args[j] = reflect.Zero(t)
			}
		}
		for _, out := range method.Call(args) {
			if e, ok := out.Interface().(error); ok && e != nil {
				fail("%s.%s: %v", v.Type(), name, e)
			}
		}
	}
}

func fail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", a...)
	os.Exit(1)
}
