// Package controllers holds the application's controllers, in the styles Beego's routing guide documents: methods
// named after the HTTP method, methods mapped by `web.Router`, methods registered one by one (`CtrlGet`), AutoRouter's
// controller and method names, and methods carrying `@router` annotations for `web.Include`.
package controllers

import (
	"github.com/beego/beego/v2/server/web"
	"github.com/beego/beego/v2/server/web/context"
)

type MainController struct {
	web.Controller
}

func (c *MainController) Get() { c.Ctx.WriteString("home") }

// Health and the others below are mapped to paths and methods by web.Router's mapping argument.
func (c *MainController) Health()    { c.Ctx.WriteString("health") }
func (c *MainController) Update()    { c.Ctx.WriteString("update") }
func (c *MainController) GetOrPost() { c.Ctx.WriteString("get or post") }
func (c *MainController) Any()       { c.Ctx.WriteString("any") }

// Hello is a functional-style handler.
func Hello(ctx *context.Context) { ctx.WriteString("hello, world") }

// PostHello is a functional-style handler.
func PostHello(ctx *context.Context) { ctx.WriteString("hello") }

// Echo is a functional-style handler.
func Echo(ctx *context.Context) { ctx.WriteString(ctx.Input.Method()) }
