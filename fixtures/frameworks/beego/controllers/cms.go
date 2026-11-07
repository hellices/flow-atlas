package controllers

import "github.com/beego/beego/v2/server/web"

// CMSController's routes are its `@router` annotations, included at the root with web.Include.
type CMSController struct {
	web.Controller
}

// @router /staticblock/:key [get]
func (c *CMSController) StaticBlock() { c.Ctx.WriteString("block " + c.Ctx.Input.Param(":key")) }

// @router /all/:key [get,post]
func (c *CMSController) AllBlock() { c.Ctx.WriteString("all " + c.Ctx.Input.Param(":key")) }
